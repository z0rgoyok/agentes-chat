import { type BrandLook, brandRandom } from "@agenteschat/client/lib/brand-look";
import { useEffect, useRef } from "react";

type Rgb = [number, number, number];

const hex = (c: string): Rgb => {
  const n = Number.parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: Rgb, b: Rgb, k: number): Rgb => a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * k)) as Rgb;
const rgba = (c: Rgb, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const WHITE: Rgb = [255, 255, 255];
const NIGHT: Rgb = [10, 10, 14];
const BLUE: Rgb = [43, 116, 230];

/** Marks drawn once per address: the file with a size, so every browser draws it (a bare viewBox has none). */
const marks = new Map<string, Promise<HTMLImageElement | null>>();
function loadMark(url: string) {
  let p = marks.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (svg) =>
          new Promise<HTMLImageElement | null>((done) => {
            const img = new Image();
            img.onload = () => done(img);
            img.onerror = () => done(null);
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace("<svg", '<svg width="256" height="256"'))}`;
          }),
      )
      .catch(() => null);
    marks.set(url, p);
  }
  return p;
}

/** A one-color mark in `color`, at `size`. */
function tinted(img: HTMLImageElement, size: number, color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  if (!x) return null;
  x.drawImage(img, 0, 0, size, size);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color;
  x.fillRect(0, 0, size, size);
  return c;
}

function readSurface(el: Element, token: string): Rgb {
  const probe = document.createElement("canvas").getContext("2d");
  const value = getComputedStyle(el).getPropertyValue(token).trim();
  if (!probe || !value) return [30, 30, 30];
  probe.fillStyle = value;
  const s = String(probe.fillStyle);
  if (s.startsWith("#")) return hex(s);
  const m = s.match(/\d+(\.\d+)?/g)?.map(Number) ?? [30, 30, 30];
  return [m[0] ?? 30, m[1] ?? 30, m[2] ?? 30];
}

async function paint(canvas: HTMLCanvasElement, look: BrandLook, template: "glow" | "pattern", surfaceToken: string) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const x = canvas.getContext("2d");
  if (!x || W === 0 || H === 0) return;
  const img = look.mark ? await loadMark(look.mark) : null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const own = look.own;
  const surface = readSurface(canvas, surfaceToken);
  const dark = (surface[0] * 299 + surface[1] * 587 + surface[2] * 114) / 1000 < 128;
  const pal = look.colors.map(hex);
  const lead = pal[0] ?? BLUE;
  const r = brandRandom(look.mark ?? look.colors.join());

  // The ground: the card's own surface, toward the brand's leading color on the art's side.
  const deep = dark ? mix(lead, NIGHT, 0.72) : mix(lead, WHITE, 0.86);
  const ground = x.createLinearGradient(0, 0, W, H);
  ground.addColorStop(0, rgba(mix(surface, deep, 0.35)));
  ground.addColorStop(1, rgba(deep));
  x.fillStyle = ground;
  x.fillRect(0, 0, W, H);

  if (template === "glow") {
    // The brand's colors as soft light, and its mark huge, tilted and cut by the edge.
    x.globalCompositeOperation = dark ? "screen" : "multiply";
    pal.slice(0, 3).forEach((c, i) => {
      const cx = W * (0.55 + 0.3 * r());
      const cy = H * (i === 0 ? 0.2 : 0.4 + 0.6 * r());
      const rad = Math.max(W, H) * (0.45 + 0.25 * r());
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(dark ? mix(c, [0, 0, 0], 0.2) : mix(c, WHITE, 0.6), dark ? 0.6 : 0.8));
      g.addColorStop(1, rgba(c, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    });
    x.globalCompositeOperation = "source-over";
    if (img) {
      const big = W > 560;
      const size = big ? H * 1.5 : H * 1.9;
      const mark = own ? img : tinted(img, 512, dark ? "rgba(255,255,255,0.2)" : rgba(mix(lead, [0, 0, 0], 0.2), 0.16));
      if (mark) {
        x.save();
        x.globalAlpha = own ? (dark ? 0.32 : 0.28) : 1;
        x.translate(W - size * 0.34, H * (big ? 0.62 : 0.6));
        x.rotate(-0.22);
        x.drawImage(mark, -size / 2, -size / 2, size, size);
        x.restore();
      }
    }
    // Grain, so the light isn't flat.
    const px = x.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const v = (r() - 0.5) * (dark ? 14 : 10);
      px.data[i] = (px.data[i] ?? 0) + v;
      px.data[i + 1] = (px.data[i + 1] ?? 0) + v;
      px.data[i + 2] = (px.data[i + 2] ?? 0) + v;
    }
    x.putImageData(px, 0, 0);
    // The words' side stays the card's own surface, so the name reads the same on every brand.
    const side = x.createLinearGradient(0, 0, W * (W > 560 ? 0.62 : 0.7), 0);
    side.addColorStop(0, rgba(surface, dark ? 0.82 : 0.86));
    side.addColorStop(0.55, rgba(surface, dark ? 0.5 : 0.55));
    side.addColorStop(1, rgba(surface, 0));
    x.fillStyle = side;
    x.fillRect(0, 0, W, H);
    return;
  }

  // The pattern: the mark in tilted rows, a brand color each (its own colors for a mark that has them), fading out
  // on the side where the dialog's tile and name sit.
  if (img) {
    const tiles = own
      ? [img]
      : pal
          .map((c) => tinted(img, 96, rgba(dark ? c : mix(c, [0, 0, 0], 0.1))))
          .filter((c): c is HTMLCanvasElement => c !== null);
    const step = 46;
    const size = 22;
    const turn = -0.21;
    const span = Math.ceil(Math.hypot(W, H) / step);
    x.save();
    x.translate(W / 2, H / 2);
    x.rotate(turn);
    for (let row = -span; row <= span; row++) {
      for (let col = -span; col <= span; col++) {
        const px = col * step + (row % 2 ? step / 2 : 0);
        const py = row * step * 0.82;
        const ux = px * Math.cos(-turn) - py * Math.sin(-turn) + W / 2;
        const fade = Math.min(1, Math.max(0, (ux - W * 0.28) / (W * 0.45)));
        const tile = tiles[(((row * 3 + col) % tiles.length) + tiles.length) % tiles.length];
        if (fade <= 0 || !tile) continue;
        x.globalAlpha = fade * (dark ? 0.55 : 0.6);
        x.drawImage(tile, px - size / 2, py - size / 2, size, size);
      }
    }
    x.restore();
    x.globalAlpha = 1;
  }
  const foot = x.createLinearGradient(0, H * 0.55, 0, H);
  foot.addColorStop(0, rgba(surface, 0));
  foot.addColorStop(1, rgba(surface, 0.55));
  x.fillStyle = foot;
  x.fillRect(0, 0, W, H);
}

/**
 * A service's brand art, made from a template, its mark and its brand's colors, behind the words of what holds it.
 * `glow` (the store's features): the colors as soft light, the mark huge and tilted, cut by the edge. `pattern` (the
 * top of a service's dialog): the mark in tilted rows, a brand color each. `surface` is the token of the surface under
 * it, which the words' side fades into. Drawn again when its size or the theme changes.
 */
export function BrandArt({
  look,
  template,
  surface,
  className,
}: {
  look: BrandLook;
  template: "glow" | "pattern";
  surface: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = `${look.mark}|${look.colors.join()}|${template}|${surface}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the look's contents.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas?.getContext?.("2d")) return;
    let frame = 0;
    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void paint(canvas, look, template, surface));
    };
    draw();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    sized?.observe(canvas);
    const themed = new MutationObserver(draw);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => {
      cancelAnimationFrame(frame);
      sized?.disconnect();
      themed.disconnect();
    };
  }, [key]);
  return (
    <span className={className ? `brand-art ${className}` : "brand-art"} aria-hidden="true">
      <canvas ref={ref} />
    </span>
  );
}
