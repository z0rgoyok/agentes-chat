import { deflateSync } from "node:zlib";
import { crc32, readZip, zip } from "../src/zip";

/**
 * Office files and pictures built in code for the Office tests (ADR 0198): a PNG encoder, a JPEG's markers, a deck
 * with a master, a layout, a theme and notes, a Word document with styles and numbering, and a package checker that
 * every writer's output must pass (content types and relationships pointing at parts that exist).
 */

const enc = new TextEncoder();

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * A PNG of `width`×`height`: color type 2 (RGB), 6 (RGBA), 0 (gray) or 3 (palette), 8 or 16 bits, its rows filtered
 * with each of PNG's filters in turn (so a decoder must undo them all).
 */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
  options: { type?: 0 | 2 | 3 | 6; depth?: 8 | 16; palette?: [number, number, number, number][] } = {},
): Uint8Array {
  const type = options.type ?? 6;
  const depth = options.depth ?? 8;
  const channels = type === 0 || type === 3 ? 1 : type === 2 ? 3 : 4;
  const bytesPer = (channels * depth) / 8;
  const rowBytes = width * bytesPer;
  const raw = new Uint8Array(height * (rowBytes + 1));
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const values =
        type === 3
          ? [options.palette?.findIndex((p) => p[0] === r && p[1] === g && p[2] === b && p[3] === a) ?? 0]
          : type === 0
            ? [r]
            : type === 2
              ? [r, g, b]
              : [r, g, b, a];
      values.forEach((v, k) => {
        if (depth === 16) {
          row[(x * channels + k) * 2] = v;
          row[(x * channels + k) * 2 + 1] = v;
        } else row[x * channels + k] = v;
      });
    }
    rows.push(row);
  }
  const bpp = Math.max(1, bytesPer);
  rows.forEach((row, y) => {
    const filter = y % 5;
    const prev = rows[y - 1];
    raw[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? (row[x - bpp] as number) : 0;
      const b = prev ? (prev[x] as number) : 0;
      const c = x >= bpp && prev ? (prev[x - bpp] as number) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter] as number;
      raw[y * (rowBytes + 1) + 1 + x] = ((row[x] as number) - predicted) & 0xff;
    }
  });
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = type;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (type === 3) {
    const palette = options.palette ?? [];
    parts.push(chunk("PLTE", new Uint8Array(palette.flatMap((p) => [p[0], p[1], p[2]]))));
    parts.push(chunk("tRNS", new Uint8Array(palette.map((p) => p[3]))));
  }
  const data = new Uint8Array(deflateSync(raw));
  // The image data split in two chunks, as encoders do for large pictures.
  const half = Math.floor(data.length / 2);
  parts.push(
    chunk("IDAT", data.subarray(0, half)),
    chunk("IDAT", data.subarray(half)),
    chunk("IEND", new Uint8Array()),
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A JPEG's markers (no image data needed by what reads them): an EXIF orientation, then a frame of `w`×`h`. */
export function jpeg(width: number, height: number, orientation = 1, components = 3): Uint8Array {
  const exif = [
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // big-endian TIFF, first IFD at 8
    ...[0x00, 0x01], // one entry
    ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00],
    ...[0x00, 0x00, 0x00, 0x00],
  ];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const sof = [
    0xff,
    0xc0,
    0x00,
    8 + components * 3,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
  ];
  for (let i = 0; i < components; i++) sof.push(i + 1, 0x11, 0x00);
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

/**
 * A GIF of `width`×`height` palette indices, compressed as encoders do (the LZW table grows and its codes with it, a
 * clear code when it is full), optionally interlaced, with a transparent index, inside a larger screen, and an
 * application extension before the frame (as animated pictures have) that a reader must skip.
 */
export function gif(
  width: number,
  height: number,
  index: (x: number, y: number) => number,
  palette: readonly [number, number, number][],
  options: {
    interlace?: boolean;
    transparent?: number;
    screen?: { width: number; height: number; left: number; top: number };
  } = {},
): Uint8Array {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const minSize = Math.max(2, bits);
  const rows: number[] = [];
  if (options.interlace) {
    for (const [start, step] of [
      [0, 8],
      [4, 8],
      [2, 4],
      [1, 2],
    ] as const) {
      for (let y = start; y < height; y += step) rows.push(y);
    }
  } else for (let y = 0; y < height; y++) rows.push(y);
  const indices = rows.flatMap((y) => Array.from({ length: width }, (_, x) => index(x, y)));
  const clear = 1 << minSize;
  let size = minSize + 1;
  let next = clear + 2;
  const table = new Map<string, number>();
  const codes: [number, number][] = [[clear, size]];
  let current = indices[0] as number;
  for (const k of indices.slice(1)) {
    const known = table.get(`${current},${k}`);
    if (known !== undefined) {
      current = known;
      continue;
    }
    codes.push([current, size]);
    if (next === 4096) {
      codes.push([clear, size]);
      table.clear();
      size = minSize + 1;
      next = clear + 2;
    } else {
      if (next >= 1 << size) size++;
      table.set(`${current},${k}`, next++);
    }
    current = k;
  }
  codes.push([current, size], [clear + 1, size]);
  const data: number[] = [];
  let acc = 0;
  let held = 0;
  for (const [code, n] of codes) {
    acc |= code << held;
    held += n;
    while (held >= 8) {
      data.push(acc & 0xff);
      acc >>>= 8;
      held -= 8;
    }
  }
  if (held > 0) data.push(acc & 0xff);
  const u16 = (n: number) => [n & 0xff, n >> 8];
  const screen = options.screen ?? { width, height, left: 0, top: 0 };
  const out = [...enc.encode("GIF89a"), ...u16(screen.width), ...u16(screen.height), 0x80 | (bits - 1), 0, 0];
  for (let i = 0; i < 1 << bits; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...enc.encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  if (options.transparent !== undefined) out.push(0x21, 0xf9, 4, 1, 0, 0, options.transparent, 0);
  out.push(0x2c, ...u16(screen.left), ...u16(screen.top), ...u16(width), ...u16(height), options.interlace ? 0x40 : 0);
  out.push(minSize);
  for (let i = 0; i < data.length; i += 255) {
    const part = data.slice(i, i + 255);
    out.push(part.length, ...part);
  }
  out.push(0, 0x3b);
  return new Uint8Array(out);
}

/** A zip's parts as text, by path. */
export function partsOf(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    readZip(bytes, { maxFiles: 500, maxBytes: 50_000_000 }).map((e) => [e.path, new TextDecoder().decode(e.data)]),
  );
}

/**
 * What an Office app checks first: every part but the relationships has a content type (an override or its
 * extension's default), and every internal relationship points at a part that is there.
 */
export function packageProblems(bytes: Uint8Array): string[] {
  const parts = partsOf(bytes);
  const problems: string[] = [];
  const types = parts["[Content_Types].xml"] ?? "";
  const defaults = new Set(
    [...types.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => (m[1] as string).toLowerCase()),
  );
  const overrides = new Set([...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1] as string));
  for (const path of Object.keys(parts)) {
    if (path === "[Content_Types].xml") continue;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!overrides.has(path) && !defaults.has(ext)) problems.push(`no content type for ${path}`);
  }
  for (const part of overrides) if (!(part in parts)) problems.push(`override for a missing part ${part}`);
  for (const [path, xml] of Object.entries(parts)) {
    if (!path.endsWith(".rels")) continue;
    const base = path.replace(/_rels\/[^/]*\.rels$/, "");
    for (const m of xml.matchAll(/<Relationship ([^>]*)\/>/g)) {
      const attrs = m[1] as string;
      if (/TargetMode="External"/.test(attrs)) continue;
      const target = /Target="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const resolved = target.startsWith("/") ? target.slice(1) : normalize(base + target);
      if (!(resolved in parts)) problems.push(`${path} points at a missing ${resolved}`);
    }
  }
  return problems;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

// ── A deck as PowerPoint writes one ──────────────────────────────────────────

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NS = `${A} ${R} ${P}`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const rels = (items: [string, string, string, boolean?][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${RELS}>${items
    .map(
      ([id, type, target, external]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("")}</Relationships>`;

export const DECK_THEME = `<a:theme ${A} name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const MASTER = `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg><p:spTree>${GROUP}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:t>Click to edit the title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit the text</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Brand bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6705600"/><a:ext cx="12192000" cy="152400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:buNone/><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `<p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content"><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const SLIDE_1 = `<p:sld ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FDFBF7"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly review</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit fontScale="90000"/></a:bodyPr><a:lstStyle/>
<a:p><a:r><a:rPr lang="en-US" b="0"/><a:t>Revenue </a:t></a:r><a:r><a:rPr lang="en-US" b="1"/><a:t>up 12%</a:t></a:r></a:p>
<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></a:rPr><a:t>Driven by Atlas</a:t></a:r></a:p>
<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>No bullet here</a:t></a:r></a:p>
<a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>First step</a:t></a:r></a:p>
</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="9" name="Footer"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr" idx="11"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="TextBox 3"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="5400000"><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="762000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr anchor="b"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2000" i="1" u="sng" strike="sngStrike"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Read the report</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:r><a:rPr lang="en-US"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:hlinkClick r:id="rId4"/></a:rPr><a:t>acme.example</a:t></a:r><a:r><a:rPr><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:hlinkClick r:id="rId5"/></a:rPr><a:t> (local)</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Rounded"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="4572000"/><a:ext cx="2438400" cy="1219200"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US"/><a:t>Goal</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 5" descr="Team photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:srcRect l="10000" r="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="9144000" y="1524000"/><a:ext cx="2438400" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
<p:pic><p:nvPicPr><p:cNvPr id="11" name="Vector"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId6"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="7" name="Dot"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="2000000" y="1000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00B050"><a:alpha val="50000"/></a:srgbClr></a:solidFill></p:spPr></p:sp></p:grpSp>
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="8" name="Arrow"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="3048000" y="2286000"/><a:ext cx="1524000" cy="762000"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="38100"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="609600" y="2743200"/><a:ext cx="4876800" cy="1371600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2438400"/><a:gridCol w="2438400"/></a:tblGrid><a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Total</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="457200"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>North</a:t></a:r></a:p><a:p><a:r><a:t>and south</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<mc:AlternateContent><mc:Choice Requires="p14"><p:sp><p:nvSpPr><p:cNvPr id="12" name="Choice"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Choice</a:t></a:r></a:p></p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="13" name="Fallback"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Fallback</a:t></a:r></a:p></p:txBody></p:sp></mc:Fallback></mc:AlternateContent>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const SLIDE_2 = `<p:sld ${NS} show="0"><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Appendix</a:t></a:r><a:fld type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

const NOTES_1 = `<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Mention the Acme deal.</a:t></a:r></a:p><a:p><a:r><a:t>Thank Ada.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

/** The team photo of the deck: 40 × 30, with transparency. */
export const DECK_PICTURE = png(40, 30, (x, y) => [x * 6, y * 8, 120, x < 20 ? 255 : 128]);

/** A two-slide deck as PowerPoint writes one: master, layout, theme, placeholders, notes, a picture, a table. */
export function pptxDeck(): Uint8Array {
  return zip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
    ],
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]])],
    [
      "ppt/presentation.xml",
      `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ["rId2", "slide", "slides/slide1.xml"],
        ["rId3", "slide", "slides/slide2.xml"],
        ["rId4", "theme", "theme/theme1.xml"],
      ]),
    ],
    ["ppt/theme/theme1.xml", DECK_THEME],
    ["ppt/slideMasters/slideMaster1.xml", MASTER],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "theme", "../theme/theme1.xml"],
      ]),
    ],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    ],
    ["ppt/slides/slide1.xml", SLIDE_1],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"],
        ["rId3", "image", "../media/image1.png"],
        ["rId4", "hyperlink", "https://acme.example/report", true],
        ["rId5", "hyperlink", "javascript:alert(1)", true],
        ["rId6", "image", "../media/image2.emf"],
      ]),
    ],
    ["ppt/slides/slide2.xml", SLIDE_2],
    ["ppt/slides/_rels/slide2.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])],
    ["ppt/notesSlides/notesSlide1.xml", NOTES_1],
    ["ppt/media/image1.png", DECK_PICTURE],
    ["ppt/media/image2.emf", new Uint8Array([1, 0, 0, 0, 0x6c, 0, 0, 0])],
  ]);
}

// ── A Word document ──────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** The logo in the document: 4 × 4, opaque. */
export const DOC_PICTURE = png(4, 4, () => [10, 20, 30, 255], { type: 2 });

const DOCUMENT = `<w:document ${W} ${R} ${A} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plano &amp; metas</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Ttulo2"/></w:pPr><w:r><w:t>Resumo</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Texto com </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>negrito</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>itálico</w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t>riscado</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve"> e &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins><w:r><w:t xml:space="preserve"> inserido</w:t></w:r></w:ins></w:p>
<w:p><w:hyperlink r:id="rId10"><w:r><w:t>o site</w:t></w:r></w:hyperlink><w:r><w:tab/></w:r><w:hyperlink r:id="rId11"><w:r><w:t>perigo</w:t></w:r></w:hyperlink><w:r><w:br/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:ada@acme.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Ada</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item um</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Sub item</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item dois</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Primeiro</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Segundo</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Região</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Sul</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>20</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="Picture 1" descr="Logo da Acme"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId20"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Vector"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId21"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:sectPr/></w:body></w:document>`;

/** A Word document with styles (one named in Portuguese), numbering, links, a field, a table and pictures. */
export function docxDocument(): Uint8Array {
  return zip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    ],
    ["_rels/.rels", rels([["rId1", "officeDocument", "word/document.xml"]])],
    ["word/document.xml", DOCUMENT],
    [
      "word/_rels/document.xml.rels",
      rels([
        ["rId1", "styles", "styles.xml"],
        ["rId2", "numbering", "numbering.xml"],
        ["rId10", "hyperlink", "https://acme.example", true],
        ["rId11", "hyperlink", "javascript:alert(1)", true],
        ["rId20", "image", "media/image1.png"],
        ["rId21", "image", "media/image2.svg"],
      ]),
    ],
    [
      "word/styles.xml",
      `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style></w:styles>`,
    ],
    [
      "word/numbering.xml",
      `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    ],
    ["word/media/image1.png", DOC_PICTURE],
    ["word/media/image2.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ]);
}
