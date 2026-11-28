import {
  catalogFont,
  type DocBlock,
  type DocCell,
  type DocParagraph,
  type DocRun,
  fontAssetOf,
} from "@agenteschat/live";
import { DOCX_STYLES, docxCore } from "../docx";
import { imageSize } from "../image-size";
import { zip } from "../zip";
import { imageTypeOf } from "./package";
import { xmlAttr } from "./xml";

/**
 * A live document as a Word file (ADR 0200): headings, paragraphs with their alignment and indent, bullet and
 * numbered lists by level, quotes, code, rules, tables (a header row repeats on each page), pictures at the width the
 * document gives them, links, and every mark (bold, italic, underline, strike, code, color). The styles are the
 * Drive's Markdown export's (`docx.ts`), so both look the same; pictures come from the file (`media`).
 */

export type DocxMediaReader = (asset: string) => Promise<{ bytes: Uint8Array; type: string } | null>;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The page's text width (A4 less the margins of `docx.ts`), in EMU: 9638 twips. */
const PAGE_EMU = Math.round((9638 / 1440) * 914_400);
/** A pixel at 96 dpi, in EMU. */
const PX_EMU = 9525;
const LEVELS = 5;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
/** Characters XML 1.0 can't hold (a control character pasted into a document) are left out. */
function clean(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff)
      continue;
    out += ch;
  }
  return out;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

interface Writer {
  links: string[];
  images: { id: string; ext: string; bytes: Uint8Array }[];
  /** Pictures by asset, read once. */
  media: Map<string, { rel: string; cx: number; cy: number; name: string } | null>;
  /** The numbering instance of the numbered list being written (each list restarts at 1). */
  ordered: number;
  orderedOpen: boolean;
  drawings: number;
  /** The file's own fonts' family names, by asset id. */
  fonts: ReadonlyMap<string, string>;
}

/** A run's typeface in Word (ADR 0220 §7): a catalog family by name, the file's own fonts by theirs. */
function faceOf(ref: string | undefined, w: Writer): string | null {
  if (!ref) return null;
  const asset = fontAssetOf(ref);
  return asset ? (w.fonts.get(asset) ?? null) : (catalogFont(ref)?.family ?? null);
}

function runXml(run: DocRun, w: Writer, extra = ""): string {
  const face = run.code ? "Martian Mono" : faceOf(run.font, w);
  // A document's sizes are CSS pixels; Word counts half points (12pt for the 16px body).
  const halfPoints = run.size ? Math.round(run.size * 1.5) : null;
  const pt = (run.size ?? 16) * 0.75;
  const bold = run.weight !== undefined ? run.weight >= 600 : run.bold;
  const props = [
    run.link ? '<w:rStyle w:val="Hyperlink"/>' : "",
    // A file's own font names its family from the font file itself: escaped as an attribute, quotes included.
    face ? `<w:rFonts w:ascii="${xmlAttr(face)}" w:hAnsi="${xmlAttr(face)}" w:cs="${xmlAttr(face)}"/>` : "",
    bold ? "<w:b/>" : "",
    run.italic ? "<w:i/>" : "",
    run.caps ? "<w:caps/>" : "",
    run.strike ? "<w:strike/>" : "",
    run.color ? `<w:color w:val="${colorHex(run.color)}"/>` : "",
    // Letter spacing in twentieths of a point.
    run.tracking ? `<w:spacing w:val="${Math.round((run.tracking / 1000) * pt * 20)}"/>` : "",
    run.code ? '<w:sz w:val="19"/>' : halfPoints ? `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>` : "",
    run.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${colorHex(run.highlight)}"/>` : "",
    run.underline ? '<w:u w:val="single"/>' : "",
    extra,
  ].join("");
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
  const parts = clean(run.text)
    .split("\n")
    .map((part, i) => `${i > 0 ? "<w:br/>" : ""}${part ? `<w:t xml:space="preserve">${esc(part)}</w:t>` : ""}`)
    .join("");
  const xml = `<w:r>${rPr}${parts}</w:r>`;
  if (!run.link) return xml;
  w.links.push(run.link);
  return `<w:hyperlink r:id="rLink${w.links.length}">${xml}</w:hyperlink>`;
}

/** "#c00" or "#cc0000" as Word's "CC0000". */
function colorHex(color: string): string {
  const hex = color.replace(/^#/, "");
  return (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toUpperCase();
}

const runsXml = (runs: readonly DocRun[], w: Writer, extra = "") => runs.map((r) => runXml(r, w, extra)).join("");

function paragraphXml(
  runs: string,
  props: { style?: string; numPr?: string; pBdr?: string; ind?: string; jc?: string },
) {
  const pPr = [
    props.style ? `<w:pStyle w:val="${props.style}"/>` : "",
    props.numPr ?? "",
    props.pBdr ?? "",
    props.ind ?? "",
    props.jc ? `<w:jc w:val="${props.jc === "justify" ? "both" : props.jc}"/>` : "",
  ].join("");
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
}

const jcOf = (align: string | undefined) => (align && align !== "left" ? align : undefined);

function listParagraph(p: DocParagraph, w: Writer, style?: string): string {
  const level = Math.min(LEVELS - 1, p.level ?? 0);
  if (!p.list) {
    w.orderedOpen = false;
    const ind = level ? `<w:ind w:left="${720 * level}"/>` : undefined;
    return paragraphXml(runsXml(p.runs, w), { style, ind, jc: jcOf(p.align) });
  }
  let num = 1;
  if (p.list === "ordered") {
    if (!w.orderedOpen) {
      w.ordered++;
      w.orderedOpen = true;
    }
    num = w.ordered + 1;
  }
  return paragraphXml(runsXml(p.runs, w), {
    style: style ?? "ListParagraph",
    numPr: `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${num}"/></w:numPr>`,
    jc: jcOf(p.align),
  });
}

async function pictureOf(asset: string, media: DocxMediaReader, w: Writer) {
  if (w.media.has(asset)) return w.media.get(asset) ?? null;
  const got = await media(asset).catch(() => null);
  const type = got ? (imageTypeOf(got.bytes) ?? got.type) : null;
  const ext = type ? EXT[type] : undefined;
  if (!got || !ext) {
    w.media.set(asset, null);
    return null;
  }
  const size = imageSize(got.bytes) ?? { width: 800, height: 600 };
  const id = `rImg${w.images.length + 1}`;
  const name = `image${w.images.length + 1}.${ext}`;
  w.images.push({ id, ext, bytes: got.bytes });
  const picture = { rel: id, cx: size.width * PX_EMU, cy: size.height * PX_EMU, name };
  w.media.set(asset, picture);
  return picture;
}

async function imageXml(block: Extract<DocBlock, { type: "image" }>, media: DocxMediaReader, w: Writer) {
  const picture = await pictureOf(block.asset, media, w);
  if (!picture) return block.alt ? paragraphXml(runXml({ text: block.alt, italic: true }, w), {}) : "";
  // The width the document gives it, else its own up to the page's.
  const cx = Math.round(block.width ? PAGE_EMU * block.width : Math.min(PAGE_EMU, picture.cx));
  const cy = Math.round((cx * picture.cy) / picture.cx);
  const n = ++w.drawings;
  const descr = attr(clean(block.alt ?? ""));
  const drawing = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${picture.name}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${picture.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  return paragraphXml(`<w:r>${drawing}</w:r>`, {});
}

function cellXml(cell: DocCell, width: number, header: boolean, w: Writer): string {
  const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : "";
  const paragraphs = cell.blocks
    .map((p) => paragraphXml(runsXml(p.runs, w, header ? "<w:b/>" : ""), { jc: jcOf(p.align) }))
    .join("");
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraphs || "<w:p/>"}</w:tc>`;
}

function tableXml(block: Extract<DocBlock, { type: "table" }>, w: Writer): string {
  const columns = Math.max(1, ...block.rows.map((r) => r.length));
  const width = Math.floor(9638 / columns);
  const rows = block.rows.map((row, r) => {
    const header = r === 0 && block.header === true;
    const cells = Array.from({ length: columns }, (_, k) => cellXml(row[k] ?? { blocks: [] }, width, header, w)).join(
      "",
    );
    return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
  });
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const sides = ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${sides}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join("")}</w:tbl>${paragraphXml("", {})}`;
}

async function blockXml(block: DocBlock, media: DocxMediaReader, w: Writer, quoted: boolean): Promise<string> {
  if (block.type !== "paragraph" || !block.list) w.orderedOpen = false;
  switch (block.type) {
    case "paragraph":
      return listParagraph(block, w, quoted ? "Quote" : undefined);
    case "heading":
      return paragraphXml(runsXml(block.runs, w, quoted ? "<w:b/>" : ""), {
        style: quoted ? "Quote" : `Heading${block.level}`,
        jc: jcOf(block.align),
      });
    case "blockquote": {
      const inner: string[] = [];
      for (const b of block.blocks) inner.push(await blockXml(b, media, w, true));
      return inner.join("");
    }
    case "code_block":
      return block.text
        .split("\n")
        .map((line) => paragraphXml(runXml({ text: line.replace(/\t/g, "  "), code: true }, w), { style: "Code" }))
        .join("");
    case "horizontal_rule":
      return paragraphXml("", {
        pBdr: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>',
      });
    case "image":
      return imageXml(block, media, w);
    case "table":
      return tableXml(block, w);
  }
}

function numbering(orderedLists: number): string {
  const level = (i: number, ordered: boolean) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? (i % 3 === 1 ? "lowerLetter" : i % 3 === 2 ? "lowerRoman" : "decimal") : "bullet"}"/><w:lvlText w:val="${ordered ? `%${i + 1}.` : ["•", "◦", "▪"][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const abstract = (id: number, ordered: boolean) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: LEVELS }, (_, i) => level(i, ordered)).join("")}</w:abstractNum>`;
  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (let i = 1; i <= orderedLists; i++) {
    const restart = Array.from(
      { length: LEVELS },
      (_, l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`,
    ).join("");
    nums.push(`<w:num w:numId="${i + 1}"><w:abstractNumId w:val="1"/>${restart}</w:num>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">${abstract(0, false)}${abstract(1, true)}${nums.join("")}</w:numbering>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

function contentTypes(exts: ReadonlySet<string>): string {
  const images = [...exts].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${images}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
}

/** A live document's blocks as a `.docx`, its title first when given. */
export async function writeDocx(
  blocks: readonly DocBlock[],
  options: { title?: string; media: DocxMediaReader; fonts?: ReadonlyMap<string, string> },
): Promise<Uint8Array> {
  const w: Writer = {
    links: [],
    images: [],
    media: new Map(),
    ordered: 0,
    orderedOpen: false,
    drawings: 0,
    fonts: options.fonts ?? new Map(),
  };
  const body: string[] = [];
  if (options.title) body.push(paragraphXml(runXml({ text: options.title }, w), { style: "Title" }));
  for (const block of blocks) body.push(await blockXml(block, options.media, w, false));
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const links = w.links.map(
    (url, i) =>
      `<Relationship Id="rLink${i + 1}" Type="${REL}/hyperlink" Target="${attr(url)}" TargetMode="External"/>`,
  );
  const images = w.images.map(
    (img, i) => `<Relationship Id="${img.id}" Type="${REL}/image" Target="media/image${i + 1}.${img.ext}"/>`,
  );
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rNumbering" Type="${REL}/numbering" Target="numbering.xml"/>${links.join("")}${images.join("")}</Relationships>`;
  return zip(
    [
      ["[Content_Types].xml", contentTypes(new Set(w.images.map((i) => i.ext)))],
      ["_rels/.rels", ROOT_RELS],
      ["docProps/core.xml", docxCore(options.title ?? "Documento")],
      ["word/document.xml", document],
      ["word/_rels/document.xml.rels", rels],
      ["word/styles.xml", DOCX_STYLES],
      ["word/numbering.xml", numbering(w.ordered)],
      ...w.images.map((img, i): [string, Uint8Array] => [`word/media/image${i + 1}.${img.ext}`, img.bytes]),
    ],
    { store: (path) => path.startsWith("word/media/") },
  );
}
