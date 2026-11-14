/**
 * A small rasterizer and the files the app icons ship as (ADR 0179): PNG and ICO, with no dependency, so the
 * icons come out the same on any machine. A scene is layers drawn back to front, each a shape (`mask`) and its colors
 * (`color`) in the scene's own units; a pixel's coverage is exact inside a shape and sampled 4×4 on its edges.
 */
import { deflateSync } from "node:zlib";

const rgbs = new Map();
/** "#rrggbb" → [r, g, b] (0..255). */
export function rgb(hex) {
  let v = rgbs.get(hex);
  if (!v) {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbs.set(hex, v);
  }
  return v;
}

/**
 * Draws `layers` into an N×N image (premultiplied floats, 0..255 and alpha 0..1). Pixel (px, py) covers the scene's
 * square [ox + px·k, ox + (px + 1)·k). A layer: `mask(x, y)` (inside or not), `color(x, y)` ("#rrggbb", read at the
 * pixel's middle, or inside the shape where it only touches the pixel), and optionally `alpha(x, y)` (0..1) and `erase` (it cuts what is under it instead of painting).
 */
export function render(N, layers, { k = 1, ox = 0, oy = 0 } = {}) {
  const px = new Float32Array(N * N * 4);
  const S = 4;
  const e = k * 0.001;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const x0 = ox + x * k;
      const y0 = oy + y * k;
      const cx = x0 + k / 2;
      const cy = y0 + k / 2;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const L of layers) {
        const mid = L.mask(cx, cy);
        // Where the color is read: the pixel's middle, or a covered sample when the shape only touches an edge.
        let hx = cx;
        let hy = cy;
        let cov;
        if (
          mid === L.mask(x0 + e, y0 + e) &&
          mid === L.mask(x0 + k - e, y0 + e) &&
          mid === L.mask(x0 + e, y0 + k - e) &&
          mid === L.mask(x0 + k - e, y0 + k - e)
        ) {
          cov = mid ? 1 : 0;
        } else {
          let n = 0;
          for (let sy = 0; sy < S; sy++)
            for (let sx = 0; sx < S; sx++) {
              const sxp = x0 + ((sx + 0.5) * k) / S;
              const syp = y0 + ((sy + 0.5) * k) / S;
              if (!L.mask(sxp, syp)) continue;
              if (n === 0 && !mid) {
                hx = sxp;
                hy = syp;
              }
              n++;
            }
          cov = n / (S * S);
        }
        if (cov > 0 && L.alpha) cov *= L.alpha(hx, hy);
        if (cov <= 0) continue;
        if (L.erase) {
          r *= 1 - cov;
          g *= 1 - cov;
          b *= 1 - cov;
          a *= 1 - cov;
          continue;
        }
        const [cr, cg, cb] = rgb(L.color(hx, hy));
        r = cr * cov + r * (1 - cov);
        g = cg * cov + g * (1 - cov);
        b = cb * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const o = (y * N + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
    }
  }
  return { N, px };
}

/** For each output index, the source indices it covers and their weights (a box filter, any ratio). */
function boxWeights(N, M) {
  const s = N / M;
  return Array.from({ length: M }, (_, i) => {
    const from = i * s;
    const to = from + s;
    const out = [];
    for (let j = Math.floor(from); j < Math.ceil(to); j++) {
      const w = Math.min(to, j + 1) - Math.max(from, j);
      if (w > 0) out.push([j, w / s]);
    }
    return out;
  });
}

/** The image at M×M, each pixel the average of what it covers (in premultiplied color, so edges don't darken). */
export function resize(img, M) {
  const { N, px } = img;
  if (M === N) return img;
  const W = boxWeights(N, M);
  const tmp = new Float32Array(M * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < M; x++)
      for (const [j, w] of W[x]) for (let c = 0; c < 4; c++) tmp[(y * M + x) * 4 + c] += px[(y * N + j) * 4 + c] * w;
  const out = new Float32Array(M * M * 4);
  for (let y = 0; y < M; y++)
    for (const [j, w] of W[y])
      for (let x = 0; x < M; x++) for (let c = 0; c < 4; c++) out[(y * M + x) * 4 + c] += tmp[(j * M + x) * 4 + c] * w;
  return { N: M, px: out };
}

/** The image in grays (its luminance), for iOS's tinted icon: the system colors it. */
export function gray(img) {
  const px = new Float32Array(img.px);
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    px[i] = l;
    px[i + 1] = l;
    px[i + 2] = l;
  }
  return { N: img.N, px };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * A PNG of the image: RGBA, or RGB when `opaque` (iOS wants its icons without alpha; whatever is see-through goes
 * on black). Each row takes the filter (none, left or up) that leaves the smallest numbers, so the pixel grid packs well.
 */
export function png(img, { opaque = false } = {}) {
  const { N, px } = img;
  const ch = opaque ? 3 : 4;
  const raw = Buffer.alloc(N * N * ch);
  for (let i = 0; i < N * N; i++) {
    const a = px[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const v = opaque ? px[i * 4 + c] : a > 0 ? px[i * 4 + c] / a : 0;
      raw[i * ch + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
    if (!opaque) raw[i * ch + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
  }
  const stride = N * ch;
  const rows = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    const tries = [0, 1, 2].map((f) => {
      const out = Buffer.alloc(stride);
      for (let i = 0; i < stride; i++) {
        const left = i >= ch ? row[i - ch] : 0;
        const above = up ? up[i] : 0;
        out[i] = (row[i] - (f === 1 ? left : f === 2 ? above : 0)) & 255;
      }
      let cost = 0;
      for (const v of out) cost += v < 128 ? v : 256 - v;
      return { f, out, cost };
    });
    const best = tries.reduce((p, q) => (q.cost < p.cost ? q : p));
    rows[y * (stride + 1)] = best.f;
    best.out.copy(rows, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A Windows .ico of PNG images: `[{ size, png }]`. */
export function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png: data }, i) => {
    const o = 6 + 16 * i;
    head[o] = size >= 256 ? 0 : size;
    head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}
