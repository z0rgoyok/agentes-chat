import { and, eq, schema } from "@agenteschat/db";
import { documentToMarkdown, readDocument } from "@agenteschat/live";
import type * as Y from "yjs";
import type { ArtifactDeps, ArtifactFileFormat, LiveExport } from "../artifacts";
import { UUID } from "../authority";
import { ValidationError } from "../errors";
import { writeDocx } from "../office/docx-write";
import { markdownToPdf } from "../pdf";
import { fileFonts } from "./file-fonts";
import { rasterPicture } from "./svg";

/**
 * What a document downloads as (ADR 0200): a Word file (its own writer, pictures included; the default), Markdown or a
 * PDF (the Drive's Markdown PDF, pictures left out). The Drive's downloads and `exportLive` both write it here, so a
 * document downloads the same whether a process holds it or not.
 */

/** A live file's picture by its id, for an export the caller already let through. */
export async function liveAssetBytes(deps: ArtifactDeps, orgId: string, fileId: string, assetId: string) {
  if (!UUID.test(assetId)) return null;
  const [row] = await deps.db
    .select()
    .from(schema.liveAssets)
    .where(
      and(
        eq(schema.liveAssets.orgId, orgId),
        eq(schema.liveAssets.artifactId, fileId),
        eq(schema.liveAssets.id, assetId),
      ),
    );
  if (!row) return null;
  const store = await deps.blobs.forConfig(orgId, row.storageConfigId).catch(() => null);
  const object = await store?.get(row.blobKey).catch(() => null);
  if (!object) return null;
  // Word, PowerPoint and our PDFs take PNG and JPEG: an SVG goes as a PNG when the server can draw one, else not.
  const picture = await rasterPicture({ bytes: object.body, contentType: row.contentType });
  return picture ? { bytes: picture.bytes, type: picture.contentType } : null;
}

/** One of a file's own fonts as its bytes (for a PDF to embed), or null. */
export async function liveFontBytes(deps: ArtifactDeps, orgId: string, fileId: string, assetId: string) {
  if (!UUID.test(assetId)) return null;
  const [row] = await deps.db
    .select()
    .from(schema.liveAssets)
    .where(
      and(
        eq(schema.liveAssets.orgId, orgId),
        eq(schema.liveAssets.artifactId, fileId),
        eq(schema.liveAssets.id, assetId),
      ),
    );
  if (!row?.font) return null;
  const store = await deps.blobs.forConfig(orgId, row.storageConfigId).catch(() => null);
  const object = await store?.get(row.blobKey).catch(() => null);
  return object ? object.body : null;
}

const TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
} as const;

/** A document written out as `format` (null: Word), or `artifact.format_unavailable`. */
export async function documentExport(
  deps: ArtifactDeps,
  file: { orgId: string; id: string; title: string },
  doc: Y.Doc,
  format: ArtifactFileFormat | null,
): Promise<LiveExport> {
  const blocks = readDocument(doc);
  if (format === "md") {
    // The title first, as the page shows it (a document's title is the file's own, not in its body).
    const text = `# ${file.title.replace(/\s+/g, " ").trim()}\n\n${documentToMarkdown(blocks)}`;
    return { body: new TextEncoder().encode(text), contentType: TYPES.md, ext: "md" };
  }
  if (format === "pdf") {
    return {
      body: markdownToPdf(documentToMarkdown(blocks), { title: file.title }),
      contentType: TYPES.pdf,
      ext: "pdf",
    };
  }
  if (format === null || format === "docx") {
    const media = (asset: string) => liveAssetBytes(deps, file.orgId, file.id, asset);
    const own = await fileFonts(deps, file.orgId, file.id);
    const fonts = new Map(own.list.map((f) => [f.id, f.family]));
    return { body: await writeDocx(blocks, { title: file.title, media, fonts }), contentType: TYPES.docx, ext: "docx" };
  }
  throw new ValidationError(
    `${format.toUpperCase()} export is not available for this file`,
    "artifact.format_unavailable",
  );
}
