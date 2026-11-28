import * as live from "@agenteschat/live";
import { bytesToBase64, type ToolImage } from "@agenteschat/providers";
import type * as Y from "yjs";
import type { ArtifactActor, ArtifactDeps } from "../artifacts";
import { MODEL_IMAGE_BYTES } from "../avatars";
import { catalogStaticFont, type Face, TextMeasurer } from "../fonts/library";
import { readAsset } from "./assets";
import { rasterOwnSvg, SVG_TYPE } from "./svg";

/**
 * What an agent sees of its edit (ADR 0220 §5): the slide, or the part of the canvas it changed, drawn by the server
 * from the native document with the same fonts and the same line breaks as the layout, as a picture the edit's result
 * carries. It is a check, not the apps' rendering: close enough to see cut text, overlaps and alignment.
 */

/** How wide the picture an agent gets is. */
const LOOK_WIDTH = 1280;
/** All the pictures of the file one look may embed. */
const LOOK_IMAGE_BYTES = 8 * 1024 * 1024;

const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** Adds a definition (a shadow, a gradient) to the drawing's `<defs>` and gives back how a piece refers to it. */
function useDef(defs: string[], def: string, ref: string): string {
  defs.push(def);
  return ref;
}

interface TextBase {
  font: live.FontRef;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
  lineHeight: number;
  tracking: number;
  caps: boolean;
  padding: number;
}

interface Segment {
  text: string;
  face: Face;
  size: number;
  color: string;
  tracking: number;
  underline: boolean;
  strike: boolean;
  width: number;
}

interface Line {
  segments: Segment[];
  width: number;
  height: number;
  indent: number;
  align: "left" | "center" | "right";
  marker?: string;
}

/** Faces drawn, so the rasterizer gets their files. */
class Faces {
  readonly used = new Map<string, Face>();
  add(face: Face): void {
    this.used.set(`${face.ref}:${face.weight}:${face.italic}`, face);
  }
  files(): Uint8Array[] {
    const out: Uint8Array[] = [];
    const seen = new Set<Uint8Array>();
    for (const face of this.used.values()) {
      const file = live.fontAssetOf(face.ref) ? null : catalogStaticFont(face.ref, face.weight, face.italic);
      if (file && !seen.has(file)) {
        seen.add(file);
        out.push(file);
      }
    }
    const base = catalogStaticFont("source-sans-3", 400, false);
    if (base && !seen.has(base)) out.push(base);
    return out;
  }
}

function family(ref: live.FontRef): string {
  return live.catalogFont(ref)?.family ?? "Source Sans 3";
}

/** Rich text broken into lines at `width`, as the layout breaks it. */
function lines(rich: live.RichDoc, base: TextBase, width: number, measurer: TextMeasurer, faces: Faces): Line[] {
  const out: Line[] = [];
  const counters: number[] = [];
  for (const p of rich) {
    const level = p.level ?? 0;
    counters.length = Math.min(counters.length, level + 1);
    let marker: string | undefined;
    if (p.list === "ordered") {
      counters[level] = (counters[level] ?? 0) + 1;
      marker = `${counters[level]}.`;
    } else if (p.list === "bullet") marker = "•";
    const indent = (p.list ? base.size * 1.2 : 0) + level * base.size * 1.5;
    const lh = p.lineHeight ?? base.lineHeight;
    let line: Line = {
      segments: [],
      width: indent,
      height: base.size * lh,
      indent,
      align: p.align ?? base.align,
      ...(marker ? { marker } : {}),
    };
    const push = () => {
      out.push(line);
      line = { segments: [], width: indent, height: base.size * lh, indent, align: p.align ?? base.align };
    };
    for (const run of p.runs) {
      const face: Face = {
        ref: run.font ?? base.font,
        weight: run.weight ?? (run.bold ? 700 : base.weight),
        italic: run.italic ?? base.italic,
      };
      faces.add(face);
      const size = run.size ?? base.size;
      const tracking = run.tracking ?? base.tracking;
      const caps = run.caps ?? base.caps;
      const color = run.color ?? base.color;
      const parts = run.text.split("\n");
      parts.forEach((part, k) => {
        if (k > 0) push();
        for (const word of part.match(/[^\s]+\s*|\s+/g) ?? []) {
          const shown = caps ? word.toUpperCase() : word;
          const w = measurer.width(shown, face, size, tracking);
          const body = measurer.width(shown.trimEnd(), face, size, tracking);
          if (line.segments.length && line.width + body > width + 0.5 && shown.trim()) push();
          line.segments.push({
            text: shown,
            face,
            size,
            color,
            tracking,
            underline: !!run.underline,
            strike: !!run.strike,
            width: w,
          });
          line.width += w;
          line.height = Math.max(line.height, size * lh);
        }
      });
    }
    push();
    const last = out[out.length - 1];
    if (last && p.spaceAfter) last.height += p.spaceAfter;
  }
  return out;
}

/** Text in a box as SVG: lines placed by alignment, runs as tspans. */
function textSvg(
  rich: live.RichDoc,
  base: TextBase,
  box: { x: number; y: number; w: number; h: number },
  measurer: TextMeasurer,
  faces: Faces,
): string {
  if (!rich.some((p) => p.runs.some((r) => r.text.trim()))) return "";
  const inner = {
    x: box.x + base.padding,
    y: box.y + base.padding,
    w: Math.max(1, box.w - 2 * base.padding),
    h: box.h - 2 * base.padding,
  };
  const laid = lines(rich, base, inner.w, measurer, faces);
  const total = laid.reduce((s, l) => s + l.height, 0);
  let y = inner.y + (base.valign === "middle" ? (inner.h - total) / 2 : base.valign === "bottom" ? inner.h - total : 0);
  const parts: string[] = [];
  for (const line of laid) {
    const ext = line.segments[0] ? measurer.extent(line.segments[0].face) : { ascent: 0.9, descent: 0.25 };
    const size = Math.max(base.size, ...line.segments.map((s) => s.size));
    // The baseline sits where CSS puts it: half the leading above the text's ascent.
    const baseline = y + (line.height - (ext.ascent + ext.descent) * size) / 2 + ext.ascent * size;
    const free = inner.w - line.width;
    let x = inner.x + line.indent + (line.align === "center" ? free / 2 : line.align === "right" ? free : 0);
    if (line.marker) {
      parts.push(
        `<text x="${n(inner.x + line.indent - base.size * 1.1)}" y="${n(baseline)}" font-family="${esc(family(base.font))}" font-size="${n(base.size)}" fill="${esc(base.color)}">${esc(line.marker)}</text>`,
      );
    }
    for (const seg of line.segments) {
      if (seg.text.trim()) {
        const deco = [seg.underline ? "underline" : "", seg.strike ? "line-through" : ""].filter(Boolean).join(" ");
        parts.push(
          `<text x="${n(x)}" y="${n(baseline)}" xml:space="preserve" font-family="${esc(family(seg.face.ref))}" font-size="${n(seg.size)}" font-weight="${seg.face.weight}"${seg.face.italic ? ' font-style="italic"' : ""}${seg.tracking ? ` letter-spacing="${n((seg.tracking / 1000) * seg.size)}"` : ""}${deco ? ` text-decoration="${deco}"` : ""} fill="${esc(seg.color)}">${esc(seg.text)}</text>`,
        );
      }
      x += seg.width;
    }
    y += line.height;
  }
  return parts.join("");
}

function gradientDef(id: string, g: live.Gradient): string {
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.sin(a) / 2;
  const dy = -Math.cos(a) / 2;
  return `<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}"><stop offset="0" stop-color="${esc(g.from)}"/><stop offset="1" stop-color="${esc(g.to)}"/></linearGradient>`;
}

function shadowDef(id: string, s: live.Shadow): string {
  const color = s.color.slice(0, 7);
  const alpha = s.color.length === 9 ? Number.parseInt(s.color.slice(7), 16) / 255 : 1;
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${n(s.x)}" dy="${n(s.y)}" stdDeviation="${n(s.blur / 2)}" flood-color="${esc(color)}" flood-opacity="${n(alpha)}"/></filter>`;
}

function dashAttr(dash: string | undefined, width: number): string {
  if (dash === "dashed") return ` stroke-dasharray="${n(width * 3)} ${n(width * 2)}"`;
  if (dash === "dotted") return ` stroke-dasharray="0 ${n(width * 2)}" stroke-linecap="round"`;
  return "";
}

function outline(kind: string, x: number, y: number, w: number, h: number, radius: number, attrs: string): string {
  switch (kind) {
    case "ellipse":
      return `<ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}"${attrs}/>`;
    case "triangle":
      return `<polygon points="${n(x + w / 2)},${n(y)} ${n(x + w)},${n(y + h)} ${n(x)},${n(y + h)}"${attrs}/>`;
    case "diamond":
      return `<polygon points="${n(x + w / 2)},${n(y)} ${n(x + w)},${n(y + h / 2)} ${n(x + w / 2)},${n(y + h)} ${n(x)},${n(y + h / 2)}"${attrs}/>`;
    default:
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="${n(Math.min(radius, w / 2, h / 2))}"${attrs}/>`;
  }
}

/** The file's pictures a look draws, as data addresses (the biggest left out past the budget). */
async function pictures(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let budget = LOOK_IMAGE_BYTES;
  for (const id of new Set(ids)) {
    const asset = await readAsset(deps, actor, orgId, fileId, id).catch(() => null);
    if (!asset || asset.bytes.byteLength > budget) continue;
    budget -= asset.bytes.byteLength;
    out.set(
      id,
      `data:${asset.row.contentType === SVG_TYPE ? SVG_TYPE : asset.row.contentType};base64,${bytesToBase64(asset.bytes)}`,
    );
  }
  return out;
}

function imageSvg(
  href: string | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fit: string,
  clip: string,
): string {
  if (!href) return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#e6e9ee"/>`;
  const aspect = fit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
  const clipped = radius > 0 ? ` clip-path="url(#${clip})"` : "";
  const def =
    radius > 0
      ? `<clipPath id="${clip}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}"/></clipPath>`
      : "";
  return `${def}<image href="${href}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="${aspect}"${clipped}/>`;
}

async function toImage(svg: string, faces: Faces): Promise<ToolImage | null> {
  const png = await rasterOwnSvg(svg, { fonts: faces.files(), width: LOOK_WIDTH });
  if (!png || png.byteLength > MODEL_IMAGE_BYTES) return null;
  return { mediaType: "image/png", data: bytesToBase64(png) };
}

/** A slide as the agent sees it after an edit, or null when this server can't draw it. */
export async function slideLook(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  doc: Y.Doc,
  slideId: string,
): Promise<ToolImage | null> {
  const deck = live.readDeck(doc);
  const slide = deck.slides.find((s) => s.id === slideId);
  if (!slide) return null;
  const theme = live.themeOf(deck.theme);
  const measurer = new TextMeasurer();
  const faces = new Faces();
  const images = await pictures(deps, actor, orgId, fileId, [
    ...slide.elements.filter((e) => e.type === "image" && e.asset).map((e) => e.asset as string),
    ...(typeof slide.bg === "object" && slide.bg ? [slide.bg.asset] : []),
  ]);
  const defs: string[] = [];
  const body: string[] = [];
  const bg = typeof slide.bg === "string" ? slide.bg : theme.colors.bg;
  body.push(`<rect width="${deck.w}" height="${deck.h}" fill="${esc(bg)}"/>`);
  if (typeof slide.bg === "object" && slide.bg)
    body.push(imageSvg(images.get(slide.bg.asset), 0, 0, deck.w, deck.h, 0, "cover", ""));
  slide.elements.forEach((el, i) => {
    const s = el.style ?? {};
    const rot = el.rot ? ` transform="rotate(${n(el.rot)} ${n(el.x + el.w / 2)} ${n(el.y + el.h / 2)})"` : "";
    const filter = s.shadow ? useDef(defs, shadowDef(`sh${i}`, s.shadow), ` filter="url(#sh${i})"`) : "";
    const opacity = s.opacity !== undefined && s.opacity < 1 ? ` opacity="${n(s.opacity)}"` : "";
    const parts: string[] = [];
    if (el.type === "shape") {
      const fill = s.gradient
        ? useDef(defs, gradientDef(`gr${i}`, s.gradient), `url(#gr${i})`)
        : live.shapeFill(theme, s);
      const width = s.stroke && s.stroke !== "none" ? (s.strokeWidth ?? 4) : 0;
      const attrs = ` fill="${esc(fill)}" stroke="${esc(width ? (s.stroke as string) : "none")}" stroke-width="${n(width)}"${dashAttr(s.dash, width)}`;
      parts.push(
        outline(
          s.shape ?? "rect",
          el.x + width / 2,
          el.y + width / 2,
          el.w - width,
          el.h - width,
          s.radius ?? 0,
          attrs,
        ),
      );
    }
    if (el.type === "image") {
      parts.push(
        imageSvg(
          el.asset ? images.get(el.asset) : undefined,
          el.x,
          el.y,
          el.w,
          el.h,
          s.radius ?? 0,
          el.fit ?? "cover",
          `cl${i}`,
        ),
      );
    }
    if (el.type === "line") {
      const width = s.strokeWidth ?? 6;
      const color = s.stroke && s.stroke !== "none" ? s.stroke : theme.colors.text;
      parts.push(
        `<line x1="${n(el.x)}" y1="${n(el.y)}" x2="${n(el.x + el.w)}" y2="${n(el.y + el.h)}" stroke="${esc(color)}" stroke-width="${n(width)}"${dashAttr(s.dash, width)}/>`,
      );
    }
    if (el.type === "chart" || el.type === "table") {
      parts.push(
        `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="${esc(theme.colors.surface)}" stroke="${esc(theme.colors.line)}"/>`,
      );
      const label = el.type === "chart" ? (el.chart?.title ?? "chart") : (el.table?.rows[0]?.join(" | ") ?? "table");
      const look = live.textLook(theme, { type: "text" }, deck.fonts);
      faces.add({ ref: look.fontRef, weight: 400, italic: false });
      parts.push(
        `<text x="${n(el.x + 24)}" y="${n(el.y + 48)}" font-family="${esc(family(look.fontRef))}" font-size="28" fill="${esc(theme.colors.muted)}">${esc(label.slice(0, 80))}</text>`,
      );
    }
    if ((el.type === "text" || el.type === "shape") && el.text) {
      const look = live.textLook(theme, el, deck.fonts);
      parts.push(
        textSvg(
          el.text,
          {
            font: look.fontRef,
            size: look.size,
            weight: look.weight,
            italic: false,
            color: look.color,
            align: look.align,
            valign: look.valign,
            lineHeight: look.lineHeight,
            tracking: look.tracking,
            caps: look.caps,
            padding: look.padding,
          },
          el,
          measurer,
          faces,
        ),
      );
    }
    body.push(`<g${rot}${filter}${opacity}>${parts.join("")}</g>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${deck.w}" height="${deck.h}" viewBox="0 0 ${deck.w} ${deck.h}"><defs>${defs.join("")}</defs>${body.join("")}</svg>`;
  return toImage(svg, faces);
}

const NOTE_FILLS: Record<string, string> = {
  yellow: "#fff3b0",
  pink: "#ffd6e4",
  blue: "#d6e8ff",
  green: "#d6f5dd",
  purple: "#e6dcff",
  gray: "#eceef1",
};

/**
 * The part of a canvas around `ids` (the shapes an edit touched, and whatever else sits there), as the agent sees it,
 * or null when this server can't draw it.
 */
export async function canvasLook(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  doc: Y.Doc,
  ids: readonly string[],
): Promise<ToolImage | null> {
  const all = live.readShapes(doc).filter((s) => !s.hidden);
  const touched = all.filter((s) => ids.includes(s.id));
  if (!touched.length) return null;
  const margin = 40;
  const x0 = Math.min(...touched.map((s) => s.x)) - margin;
  const y0 = Math.min(...touched.map((s) => s.y)) - margin;
  let x1 = Math.max(...touched.map((s) => s.x + s.w)) + margin;
  let y1 = Math.max(...touched.map((s) => s.y + s.h)) + margin;
  // A region too big to read is cut to the first 4000 units each way.
  x1 = Math.min(x1, x0 + 4000);
  y1 = Math.min(y1, y0 + 4000);
  const w = x1 - x0;
  const h = y1 - y0;
  const inside = all.filter((s) => s.x < x1 && s.x + s.w > x0 && s.y < y1 && s.y + s.h > y0);
  const measurer = new TextMeasurer();
  const faces = new Faces();
  const images = await pictures(
    deps,
    actor,
    orgId,
    fileId,
    inside.filter((s) => s.type === "image" && s.asset).map((s) => s.asset as string),
  );
  const defs: string[] = [];
  const body: string[] = [`<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="#fafafa"/>`];
  const byId = live.shapeIndex(all);
  inside.forEach((s, i) => {
    const filter = s.shadow ? useDef(defs, shadowDef(`sh${i}`, s.shadow), ` filter="url(#sh${i})"`) : "";
    const rot = s.rot ? ` transform="rotate(${n(s.rot)} ${n(s.x + s.w / 2)} ${n(s.y + s.h / 2)})"` : "";
    const parts: string[] = [];
    const base: TextBase = {
      font: s.style?.font ?? "source-sans-3",
      size: s.style?.size ?? 24,
      weight: s.style?.weight ?? 400,
      italic: false,
      color: s.style?.color ?? "#1d2129",
      align: s.style?.align ?? (s.type === "shape" ? "center" : "left"),
      valign: s.style?.valign ?? (s.type === "shape" ? "middle" : "top"),
      lineHeight: s.style?.lineHeight ?? 1.35,
      tracking: s.style?.tracking ?? 0,
      caps: s.style?.caps ?? false,
      padding: s.style?.padding ?? (s.type === "shape" || s.type === "note" ? 16 : 0),
    };
    switch (s.type) {
      case "frame":
        parts.push(
          `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="12" fill="${esc(s.fill && s.fill !== "none" ? s.fill : "#f1f2f4")}"/>`,
        );
        if (s.name)
          parts.push(
            `<text x="${n(s.x)}" y="${n(s.y - 10)}" font-family="Source Sans 3" font-size="20" fill="#5b6370">${esc(s.name)}</text>`,
          );
        break;
      case "note":
        parts.push(
          `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="6" fill="${NOTE_FILLS[s.color ?? "yellow"] ?? NOTE_FILLS.yellow}"/>`,
        );
        break;
      case "shape": {
        const fill = s.gradient
          ? useDef(defs, gradientDef(`gr${i}`, s.gradient), `url(#gr${i})`)
          : s.fill && s.fill !== "none"
            ? s.fill
            : s.fill === "none"
              ? "none"
              : "#ffffff";
        const width = s.stroke === "none" ? 0 : (s.strokeWidth ?? 2);
        const stroke = s.stroke && s.stroke !== "none" ? s.stroke : "#c4c9d1";
        parts.push(
          outline(
            s.kind ?? "rect",
            s.x + width / 2,
            s.y + width / 2,
            s.w - width,
            s.h - width,
            s.radius ?? 12,
            ` fill="${esc(fill)}" stroke="${esc(width ? stroke : "none")}" stroke-width="${n(width)}"${dashAttr(s.dash, width)}`,
          ),
        );
        break;
      }
      case "image":
        parts.push(
          imageSvg(s.asset ? images.get(s.asset) : undefined, s.x, s.y, s.w, s.h, s.radius ?? 0, "cover", `cl${i}`),
        );
        break;
      case "arrow": {
        const from = s.from ? live.resolveEnd(s.from, byId) : null;
        const to = s.to ? live.resolveEnd(s.to, byId) : null;
        if (from && to) {
          // As the apps draw it: border to border, its route, a head at each end that has one, its label in the middle.
          const width = s.strokeWidth ?? 2;
          const color = esc(s.stroke && s.stroke !== "none" ? s.stroke : "#5b6370");
          const line = live.arrowPath(from, to);
          const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
          const head = 12 + width;
          const atStart = s.heads?.start === "arrow" && len > 1;
          const atEnd = (s.heads?.end ?? "arrow") === "arrow" && len > 1;
          const routed = live.routeArrow(line, s.route ?? "straight", {
            start: atStart ? head * 0.8 : 0,
            end: atEnd ? head * 0.8 : 0,
          });
          const tip = (at: { x: number; y: number }, dir: { x: number; y: number }) =>
            `<polygon points="${live
              .arrowHeadPoints(at, dir, head)
              .map((p) => `${n(p.x)},${n(p.y)}`)
              .join(" ")}" fill="${color}"/>`;
          parts.push(
            `<path d="${routed.d}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round"${s.dashed ? ` stroke-dasharray="${n(width * 3)} ${n(width * 2)}"` : ""}/>`,
          );
          if (atEnd) parts.push(tip(routed.end, routed.endDir));
          if (atStart) parts.push(tip(routed.start, { x: -routed.startDir.x, y: -routed.startDir.y }));
          if (s.label?.trim()) {
            const size = 18;
            const lw = Math.min(
              400,
              measurer.width(s.label, { ref: base.font, weight: 400, italic: false }, size) + 16,
            );
            const box = { x: routed.mid.x - lw / 2, y: routed.mid.y - size, w: lw, h: size * 2 };
            parts.push(
              `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="6" fill="#fafafa"/>`,
              textSvg(
                [{ runs: [{ text: s.label }] }],
                { ...base, size, color: "#1d2129", align: "center", valign: "middle", padding: 0 },
                box,
                measurer,
                faces,
              ),
            );
          }
        }
        break;
      }
      case "draw":
        if (s.points?.length) {
          const pts = [];
          for (let k = 0; k + 1 < s.points.length; k += 2)
            pts.push(`${n(s.x + (s.points[k] ?? 0))},${n(s.y + (s.points[k + 1] ?? 0))}`);
          parts.push(
            `<polyline points="${pts.join(" ")}" fill="none" stroke="${esc(s.stroke ?? "#1d2129")}" stroke-width="${n(s.strokeWidth ?? 4)}"/>`,
          );
        }
        break;
      case "html":
      case "file":
      case "pending":
        parts.push(
          `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="10" fill="#ffffff" stroke="#c4c9d1"/>`,
        );
        break;
    }
    if ((s.type === "text" || s.type === "note" || s.type === "shape") && s.text)
      parts.push(textSvg(s.text, base, s, measurer, faces));
    body.push(`<g${rot}${filter}>${parts.join("")}</g>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}"><defs>${defs.join("")}</defs>${body.join("")}</svg>`;
  return toImage(svg, faces);
}
