import { and, eq, isNotNull, schema } from "@agenteschat/db";
import { fontAssetRef } from "@agenteschat/live";
import { type ArtifactActor, type ArtifactDeps, liveFileAccess } from "../artifacts";
import { NotFoundError, ValidationError } from "../errors";
import { copyAssetFrom, type LiveAsset, type LiveAssetFont, readAsset } from "./assets";

/**
 * A live file's own fonts (ADR 0220 §2): fonts from the Drive copied into the file, so whoever opens it draws them.
 * People and agents name them by their family ("Brand Sans") or as `asset:<id>`.
 */

export interface FileFont extends LiveAssetFont {
  id: string;
}

/** The file's fonts, and a lookup from a family name (any case) to the font that has it. */
export async function fileFonts(
  deps: ArtifactDeps,
  orgId: string,
  fileId: string,
): Promise<{ list: FileFont[]; byFamily: Map<string, string> }> {
  const rows = await deps.db
    .select({ id: schema.liveAssets.id, font: schema.liveAssets.font })
    .from(schema.liveAssets)
    .where(
      and(
        eq(schema.liveAssets.orgId, orgId),
        eq(schema.liveAssets.artifactId, fileId),
        isNotNull(schema.liveAssets.font),
      ),
    );
  const list = rows.flatMap((r) => (r.font ? [{ id: r.id, ...(r.font as LiveAssetFont) }] : []));
  const byFamily = new Map<string, string>();
  // The regular face first, so a family's name picks the face people expect.
  for (const f of [...list].sort(
    (a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400) || Number(a.italic) - Number(b.italic),
  )) {
    const key = f.family.trim().toLowerCase();
    if (!byFamily.has(key)) byFamily.set(key, f.id);
    const styled = `${f.family} ${f.style}`.trim().toLowerCase();
    if (!byFamily.has(styled)) byFamily.set(styled, f.id);
  }
  return { list, byFamily };
}

/** The file's fonts for whoever reads it (the apps' font lists), regular faces first; not found otherwise. */
export async function readFileFonts(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
): Promise<FileFont[]> {
  if (!(await liveFileAccess(deps, actor, orgId, fileId))) {
    throw new NotFoundError("Artifact not found", "artifact.not_found");
  }
  const { list } = await fileFonts(deps, orgId, fileId);
  return list.sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      Math.abs(a.weight - 400) - Math.abs(b.weight - 400) ||
      Number(a.italic) - Number(b.italic),
  );
}

/** The bytes of some of the file's fonts, to measure text with. */
export async function fileFontBytes(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  ids: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const id of new Set(ids)) {
    const asset = await readAsset(deps, actor, orgId, fileId, id).catch(() => null);
    if (asset?.row.font) out.set(id, asset.bytes);
  }
  return out;
}

/** Brings a font from the Drive into the file (under the reader's check), or refuses what isn't a font. */
export async function bringFont(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  driveFileId: string,
): Promise<LiveAsset & { font: LiveAssetFont }> {
  const asset = await copyAssetFrom(deps, actor, orgId, fileId, { artifactId: driveFileId });
  if (!asset.font) throw new ValidationError("That file isn't a font: give a .ttf, .otf or .woff from the Drive");
  return asset as LiveAsset & { font: LiveAssetFont };
}

/** A file's font in words, for a read or a result. */
export function fileFontWords(f: Pick<FileFont, "id" | "family" | "style" | "embedding">): string {
  const rights = f.embedding === "restricted" ? ", not embedded in exports (its license)" : "";
  return `"${f.family}${f.style && f.style !== "Regular" ? ` ${f.style}` : ""}" (${fontAssetRef(f.id)}${rights})`;
}
